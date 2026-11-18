output "instance_name" {
  value = aws_lightsail_instance.relay.name
}

output "ip_address" {
  value = aws_lightsail_static_ip.relay.ip_address
}

output "relay_url" {
  value = "https://${var.relay_domain}"
}

output "app_url" {
  value = var.app_domain == "" ? null : "https://${var.app_domain}"
}

output "zone_id" {
  value = data.aws_route53_zone.zone.zone_id
}
