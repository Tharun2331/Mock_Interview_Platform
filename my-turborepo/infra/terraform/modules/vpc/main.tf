# Step 1: Create a VPC
resource "aws_vpc" "myvpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "prepilot-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
  }
}

# Step 2: Public subnets (one per AZ). Public = has a route to the IGW.
resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.myvpc.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name        = "prepilot-public-${count.index}-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
    Tier        = "public"
  }
}

# Step 3: Private subnets (one per AZ). Private = egress only via NAT.
resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.myvpc.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name        = "prepilot-private-${count.index}-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
    Tier        = "private"
  }
}

# Step 4: Internet Gateway (public egress/ingress).
resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.myvpc.id

  tags = {
    Name        = "prepilot-igw-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
  }
}

# Step 5: Public route table -> IGW, associated with every public subnet.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.myvpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = {
    Name        = "prepilot-public-rt-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Step 6: NAT gateway (optional) — private-subnet egress to Bedrock/Transcribe/etc.
# Disabled by default to avoid the ~$32/mo idle cost during local development.
# Set enable_nat_gateway = true when deploying ECS into the private subnets.
resource "aws_eip" "nat" {
  count  = var.enable_nat_gateway ? 1 : 0
  domain = "vpc"

  tags = {
    Name        = "prepilot-nat-eip-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
  }
}

resource "aws_nat_gateway" "nat" {
  count         = var.enable_nat_gateway ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name        = "prepilot-nat-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
  }

  # NAT needs the IGW attached first.
  depends_on = [aws_internet_gateway.igw]
}

# Step 7: Private route table. The default route to NAT is only added when
# NAT is enabled; until then private subnets have no internet egress (fine for
# local dev, since nothing runs in them yet).
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.myvpc.id

  tags = {
    Name        = "prepilot-private-rt-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
  }
}

resource "aws_route" "private_nat" {
  count                  = var.enable_nat_gateway ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.nat[0].id
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Step 8: Security groups — ALB (public) -> ECS (private) -> Redis (private).

# ALB: accepts HTTP/HTTPS from the internet.
resource "aws_security_group" "alb" {
  name        = "prepilot-alb-${var.environment}"
  description = "ALB ingress from internet"
  vpc_id      = aws_vpc.myvpc.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS / WSS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "prepilot-alb-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
  }
}

# ECS: only reachable from the ALB, on the container port.
resource "aws_security_group" "ecs" {
  name        = "prepilot-ecs-${var.environment}"
  description = "ECS tasks ingress from ALB only"
  vpc_id      = aws_vpc.myvpc.id

  ingress {
    description     = "App traffic from ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "prepilot-ecs-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
  }
}

# Redis: only reachable from ECS tasks, on the Redis port.
resource "aws_security_group" "redis" {
  name        = "prepilot-redis-${var.environment}"
  description = "ElastiCache Redis ingress from ECS only"
  vpc_id      = aws_vpc.myvpc.id

  ingress {
    description     = "Redis from ECS"
    from_port       = var.redis_port
    to_port         = var.redis_port
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "prepilot-redis-${var.environment}"
    Project     = "prepilot"
    Environment = var.environment
  }
}
