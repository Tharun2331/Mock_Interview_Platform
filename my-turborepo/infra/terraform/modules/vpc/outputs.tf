output "vpc_id" {
  value = aws_vpc.myvpc.id
}

output "vpc_cidr" {
  value = aws_vpc.myvpc.cidr_block
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "nat_gateway_id" {
  value = one(aws_nat_gateway.nat[*].id)
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "ecs_security_group_id" {
  value = aws_security_group.ecs.id
}

output "redis_security_group_id" {
  value = aws_security_group.redis.id
}
