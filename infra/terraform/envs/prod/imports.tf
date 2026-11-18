# What existed before this code (made by deploy/relay/aws-lightsail.sh on 2026-11-15 and by hand).
# The first apply only records them in the state; it changes nothing on them. These blocks can go
# once that apply has run.

import {
  to = module.relay.aws_lightsail_instance.relay
  id = "parawatch-relay"
}

import {
  to = module.relay.aws_lightsail_static_ip.relay
  id = "parawatch-relay-ip"
}

import {
  to = module.relay.aws_lightsail_static_ip_attachment.relay
  id = "parawatch-relay-ip"
}

import {
  to = module.relay.aws_route53_record.relay
  id = "${module.relay.zone_id}_relay.parawatch.penspanic.com_A"
}

import {
  to = module.relay.aws_route53_record.app[0]
  id = "${module.relay.zone_id}_parawatch.penspanic.com_A"
}
