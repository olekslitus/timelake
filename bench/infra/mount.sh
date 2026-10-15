#!/usr/bin/env bash
# Mount the instance's NVMe SSD (if it has one) at /mnt/bench for benchmark data and logs; else /mnt/bench stays on
# the EBS root volume. Run as root at first boot (bootstrap.sh) and after every start: stopping wipes the SSD.
set -euxo pipefail
mkdir -p /mnt/bench
dev=$(lsblk -dpno NAME,MODEL | awk '/Instance Storage/ {print $1; exit}')
if [ -n "$dev" ] && ! mountpoint -q /mnt/bench; then
  mkfs.xfs -f "$dev"
  mount -o noatime "$dev" /mnt/bench
fi
mkdir -p /mnt/bench/data /mnt/bench/logs
chown -R ec2-user: /mnt/bench
