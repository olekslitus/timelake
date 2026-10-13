#!/usr/bin/env bash
# First boot of the benchmark instance (run as root by the stack's user data): data directory, swap, toolchains,
# and the repo at the given commit. Builds and benchmark runs are bench/infra/remote.sh, started via ssm.sh.
set -euxo pipefail
ref=$1

# /mnt/bench holds benchmark data and logs (the "local" target): the instance's NVMe SSD if it has one (wiped
# when the instance stops), else the EBS root volume.
mkdir -p /mnt/bench
dev=$(lsblk -dpno NAME,MODEL | awk '/Instance Storage/ {print $1; exit}')
if [ -n "$dev" ]; then
  mkfs.xfs -f "$dev"
  mount -o noatime "$dev" /mnt/bench
fi
chown ec2-user: /mnt/bench
# Swap, so Rust builds and the larger queries don't get killed on small instances.
fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

dnf install -y git gcc gcc-c++ make cmake clang perl openssl-devel golang jq

sudo -iu ec2-user bash -s "$ref" <<'EOF'
set -euxo pipefail
ref=$1
curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
curl -fsSL https://astral.sh/uv/install.sh | sh
git clone https://github.com/polythings/timelake ~/timelake
git -C ~/timelake checkout "$ref"
mkdir -p /mnt/bench/data /mnt/bench/logs
ln -s /mnt/bench/data ~/timelake/bench/data
EOF
touch /var/lib/timelake-bootstrap.done
