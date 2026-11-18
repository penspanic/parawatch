variable "name" {
  description = "Name of the Lightsail instance; the static IP is named \"<name>-ip\"."
  type        = string
}

variable "availability_zone" {
  description = "Lightsail availability zone, such as ap-northeast-2a."
  type        = string
}

variable "bundle_id" {
  description = "Lightsail bundle (size). micro_3_0 is 1 GB."
  type        = string
  default     = "micro_3_0"
}

variable "blueprint_id" {
  description = "Lightsail image."
  type        = string
  default     = "ubuntu_24_04"
}

variable "zone_name" {
  description = "Route 53 hosted zone the names live in, such as example.com."
  type        = string
}

variable "relay_domain" {
  description = "Name the machines and the phone reach the relay at."
  type        = string
}

variable "app_domain" {
  description = "Name the phone web app is served at; empty for none."
  type        = string
  default     = ""
}

variable "auto_snapshot" {
  description = "Keep daily automatic snapshots of the instance (Lightsail keeps the last seven)."
  type        = bool
  default     = true
}

variable "snapshot_time" {
  description = "When the daily snapshot starts, HH:00 in UTC."
  type        = string
  default     = "18:00"
}
