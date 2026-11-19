# A parawatch relay on one Lightsail instance: the instance, a static IP, the open ports and its DNS
# name. The phone web app is served elsewhere (modules/web). What runs inside the instance (Node, the relay service, Caddy) is set up by
# deploy/relay/setup.sh, not here.

resource "aws_lightsail_instance" "relay" {
  name              = var.name
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id

  dynamic "add_on" {
    for_each = var.auto_snapshot ? [1] : []
    content {
      type          = "AutoSnapshot"
      snapshot_time = var.snapshot_time
      status        = "Enabled"
    }
  }

  lifecycle {
    # the relay's spaces live on this disk: never replace it by accident
    prevent_destroy = true
    # first-boot script of an instance made before this code; changing it would replace the instance
    ignore_changes = [user_data]
  }
}

resource "aws_lightsail_static_ip" "relay" {
  name = "${var.name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "relay" {
  static_ip_name = aws_lightsail_static_ip.relay.name
  instance_name  = aws_lightsail_instance.relay.name
}

resource "aws_lightsail_instance_public_ports" "relay" {
  instance_name = aws_lightsail_instance.relay.name

  # SSH takes only the short-lived certificates Lightsail hands out; deploys use them too
  port_info {
    protocol   = "tcp"
    from_port  = 22
    to_port    = 22
    cidrs      = ["0.0.0.0/0"]
    ipv6_cidrs = ["::/0"]
  }
  port_info {
    protocol   = "tcp"
    from_port  = 80
    to_port    = 80
    cidrs      = ["0.0.0.0/0"]
    ipv6_cidrs = ["::/0"]
  }
  port_info {
    protocol   = "tcp"
    from_port  = 443
    to_port    = 443
    cidrs      = ["0.0.0.0/0"]
    ipv6_cidrs = ["::/0"]
  }
}

data "aws_route53_zone" "zone" {
  name = var.zone_name
}

resource "aws_route53_record" "relay" {
  zone_id = data.aws_route53_zone.zone.zone_id
  name    = var.relay_domain
  type    = "A"
  ttl     = 300
  records = [aws_lightsail_static_ip.relay.ip_address]
}
