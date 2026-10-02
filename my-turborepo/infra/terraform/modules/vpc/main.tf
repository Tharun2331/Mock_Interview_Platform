locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # One MASQUERADE rule per private subnet, for the NAT instance's user_data.
  nat_masquerade_rules = join("\n", [
    for cidr in var.private_subnet_cidrs :
    "iptables -t nat -A POSTROUTING -o \"$IFACE\" -s ${cidr} -j MASQUERADE"
  ])
}

data "aws_region" "current" {}
data "aws_partition" "current" {}

# Step 1: Create a VPC
resource "aws_vpc" "myvpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.common_tags, { Name = "prepilot-${var.environment}" })
}

# Step 2: Public subnets (one per AZ). Public = has a route to the IGW.
# Only the NAT instance lives here. The app server is private and reached by
# CloudFront through a VPC origin, so nothing else needs a public address.
resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.myvpc.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "prepilot-public-${count.index}-${var.environment}"
    Tier = "public"
  })
}

# Step 3: Private subnets (one per AZ). Private = egress only via the NAT
# instance, plus the free gateway endpoints for S3 and DynamoDB.
resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.myvpc.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = merge(local.common_tags, {
    Name = "prepilot-private-${count.index}-${var.environment}"
    Tier = "private"
  })
}

# Step 4: Internet Gateway (public egress/ingress).
resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.myvpc.id

  tags = merge(local.common_tags, { Name = "prepilot-igw-${var.environment}" })
}

# Step 5: Public route table -> IGW, associated with every public subnet.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.myvpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = merge(local.common_tags, { Name = "prepilot-public-rt-${var.environment}" })
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Step 6: NAT instance (optional) — private-subnet egress for everything that
# has no gateway endpoint: Bedrock, SQS, Cognito (JWKS + admin API), SSM,
# CloudWatch Logs, and api.github.com. See ADR-0008.
#
# An EC2 instance instead of a managed NAT Gateway: ~$7/mo all-in (t4g.nano,
# its public IPv4, an 8 GB root volume) against ~$33/mo plus $0.045/GB for the
# gateway. The trade is that this is ours to patch and a single point of
# failure for all outbound traffic — accepted for v1.
#
# Off by default so dev costs nothing while no app server runs in it.
#
# It sits in the first public subnet's AZ. Put the app server in the matching
# private subnet (index 0): traffic from the other AZ crosses an AZ boundary
# and is billed at $0.01/GB each way.

# Latest Amazon Linux 2023 for arm64 (t4g is Graviton). A public AWS parameter,
# not a secret, so reading it at plan time is fine. `ami` is ignored after
# creation below, otherwise every new AL2023 release would replace the instance.
data "aws_ssm_parameter" "al2023_arm64" {
  count = var.enable_nat_instance ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# Inbound 443 from the private subnets only, outbound 443 only. A security
# group cannot name "AWS services" or "GitHub" as destinations, so the
# tightness is in the port: nothing but HTTPS leaves through this instance.
# Security groups apply to forwarded traffic too, so this is what actually
# filters the private subnets' egress.
#
# DNS and NTP need no rules: the VPC resolver and Amazon Time Sync are
# link-local addresses that security groups do not filter.
resource "aws_security_group" "nat" {
  count       = var.enable_nat_instance ? 1 : 0
  name        = "prepilot-nat-${var.environment}"
  description = "NAT instance: HTTPS from private subnets, HTTPS out"
  vpc_id      = aws_vpc.myvpc.id

  ingress {
    description = "HTTPS from private subnets, to be forwarded"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.private_subnet_cidrs
  }

  egress {
    description = "HTTPS to AWS APIs and api.github.com"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "prepilot-nat-${var.environment}" })
}

# Session Manager access instead of SSH: no key pair, no port 22. The SSM
# agent ships in AL2023 and only makes outbound 443 calls, which the security
# group above already allows. AmazonSSMManagedInstanceCore is AWS's baseline
# for this; several of its actions (ssmmessages:*, ec2messages:*) have no
# resource-level permissions.
data "aws_iam_policy_document" "nat_assume" {
  count = var.enable_nat_instance ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "nat" {
  count              = var.enable_nat_instance ? 1 : 0
  name               = "prepilot-nat-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.nat_assume[0].json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "nat_ssm" {
  count      = var.enable_nat_instance ? 1 : 0
  role       = aws_iam_role.nat[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "nat" {
  count = var.enable_nat_instance ? 1 : 0
  name  = "prepilot-nat-${var.environment}"
  role  = aws_iam_role.nat[0].name

  tags = local.common_tags
}

resource "aws_instance" "nat" {
  count                  = var.enable_nat_instance ? 1 : 0
  ami                    = data.aws_ssm_parameter.al2023_arm64[0].insecure_value
  instance_type          = var.nat_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.nat[0].id]
  iam_instance_profile   = aws_iam_instance_profile.nat[0].name

  # Required for NAT: the instance forwards packets whose source and
  # destination are not its own address.
  source_dest_check = false

  # Standard credits cap the bill. NAT is light on CPU, and in unlimited mode a
  # runaway would bill surplus credits instead of throttling.
  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_type = "gp3"
    encrypted   = true
  }

  # Enables forwarding and masquerades the private subnets behind this
  # instance's public address, then turns on unattended security updates.
  #
  # AL2023 locks dnf to the release the AMI shipped with, so without
  # `releasever=latest` dnf-automatic would never find anything to install.
  # Kernel updates still need a reboot, which is left manual on purpose: a
  # reboot drops every live interview's Bedrock stream.
  #
  # The swap file comes first. A t4g.nano has 512 MB, and dnf loading the full
  # AL2023 repo metadata gets OOM-killed without it — which left the first
  # NAT instance with forwarding off and no iptables at all. It stays in fstab
  # so dnf-automatic's daily runs have it too.
  user_data_replace_on_change = true
  user_data                   = <<-EOT
    #!/bin/bash
    set -euo pipefail

    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo "/swapfile none swap defaults 0 0" >> /etc/fstab

    echo latest > /etc/dnf/vars/releasever
    dnf install -y iptables-services dnf-automatic

    echo "net.ipv4.ip_forward = 1" > /etc/sysctl.d/90-nat.conf
    sysctl -p /etc/sysctl.d/90-nat.conf

    IFACE=$(ip route show default | awk '{print $5; exit}')
    iptables -F
    iptables -t nat -F
    iptables -P FORWARD ACCEPT
    ${local.nat_masquerade_rules}
    iptables-save > /etc/sysconfig/iptables
    systemctl enable --now iptables

    sed -i 's/^upgrade_type.*/upgrade_type = security/; s/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf
    systemctl enable --now dnf-automatic.timer
  EOT

  tags = merge(local.common_tags, { Name = "prepilot-nat-${var.environment}" })

  lifecycle {
    ignore_changes = [ami]
  }

  depends_on = [aws_internet_gateway.igw]
}

# Step 7: Private route table. The default route to the NAT instance is only
# added when it is enabled; until then private subnets reach S3 and DynamoDB
# through the gateway endpoints and nothing else.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.myvpc.id

  tags = merge(local.common_tags, { Name = "prepilot-private-rt-${var.environment}" })
}

resource "aws_route" "private_nat" {
  count                  = var.enable_nat_instance ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat[0].primary_network_interface_id
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Step 8: Gateway endpoints for S3 and DynamoDB. Free, unlike interface
# endpoints, and they keep the backend's highest-volume calls (every session
# read and write) off the NAT instance's bandwidth. Access is still scoped by
# the app's IAM role; the endpoint policy is left at its full-access default.
resource "aws_vpc_endpoint" "gateway" {
  for_each          = toset(["s3", "dynamodb"])
  vpc_id            = aws_vpc.myvpc.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = merge(local.common_tags, { Name = "prepilot-${each.key}-endpoint-${var.environment}" })
}
