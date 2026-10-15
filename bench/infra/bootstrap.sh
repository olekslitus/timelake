#!/usr/bin/env bash
# First boot of the benchmark instance (run as root by the stack's user data): toolchains, Docker (TimescaleDB runs
# in a container), swap, the repo at the given commit, and the data directory. Builds and benchmark runs are
# bench/infra/remote.sh, started via ssm.sh.
set -euxo pipefail
ref=$1

# Swap, so Rust builds and the larger queries don't get killed on small instances.
fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab

dnf install -y git gcc gcc-c++ make cmake clang perl openssl-devel golang jq docker
systemctl enable --now docker
usermod -aG docker ec2-user

sudo -iu ec2-user bash -s "$ref" <<'EOF'
set -euxo pipefail
ref=$1
curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
curl -fsSL https://astral.sh/uv/install.sh | sh
git clone https://github.com/polythings/timelake ~/timelake
git -C ~/timelake checkout "$ref"
EOF

# /mnt/bench holds benchmark data and logs (the "local" target): the NVMe SSD if the instance has one, else EBS.
bash ~ec2-user/timelake/bench/infra/mount.sh
sudo -u ec2-user ln -s /mnt/bench/data ~ec2-user/timelake/bench/data
touch /var/lib/timelake-bootstrap.done
