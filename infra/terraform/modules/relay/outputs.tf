output "instance_name" {
  value = aws_lightsail_instance.relay.name
}

output "ip_address" {
  value = aws_lightsail_static_ip.relay.ip_address
}

output "relay_url" {
  value = "https://${var.relay_domain}"
}

output "instance_arn" {
  value = aws_lightsail_instance.relay.arn
}

output "relay_domain" {
  value = var.relay_domain
}

output "zone_id" {
  value = data.aws_route53_zone.zone.zone_id
}
