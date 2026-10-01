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

output "private_route_table_id" {
  value = aws_route_table.private.id
}

output "nat_instance_id" {
  description = "Null when enable_nat_instance is false."
  value       = one(aws_instance.nat[*].id)
}

output "nat_security_group_id" {
  description = "Null when enable_nat_instance is false."
  value       = one(aws_security_group.nat[*].id)
}
