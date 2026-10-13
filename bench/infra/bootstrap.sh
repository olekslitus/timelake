#!/usr/bin/env bash
# First boot of the benchmark instance (run as root by the stack's user data): instance-store SSD, toolchains,
# and the repo at the given commit. Builds and benchmark runs are bench/infra/remote.sh, started via ssm.sh.
set -euxo pipefail
ref=$1

# The local NVMe SSD holds benchmark data and logs (the "local disk" target). It is wiped when the instance stops.
dev=$(lsblk -dpno NAME,MODEL | awk '/Instance Storage/ {print $1; exit}')
mkfs.xfs -f "$dev"
mkdir -p /mnt/nvme
mount -o noatime "$dev" /mnt/nvme
chown ec2-user: /mnt/nvme

dnf install -y git gcc gcc-c++ make cmake clang perl openssl-devel golang jq

sudo -iu ec2-user bash -s "$ref" <<'EOF'
set -euxo pipefail
ref=$1
curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
curl -fsSL https://astral.sh/uv/install.sh | sh
git clone https://github.com/polythings/timelake ~/timelake
git -C ~/timelake checkout "$ref"
mkdir -p /mnt/nvme/data /mnt/nvme/logs
ln -s /mnt/nvme/data ~/timelake/bench/data
EOF
touch /var/lib/timelake-bootstrap.done
