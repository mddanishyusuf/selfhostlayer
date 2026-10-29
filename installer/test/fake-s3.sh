#!/usr/bin/env bash
# Test helper (VM only): runs panel/scripts/fake-s3.ts at http://127.0.0.1:4999
# (access key "test", secret "testsecret"). Expects fake-s3.ts and s3.ts next
# to this script (scripts/dev-vm.sh copies them). Undo with --remove.
#   sudo bash fake-s3.sh [--remove]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir=/root/layer-fake-s3
systemctl stop layer-test-s3 2>/dev/null || true
systemctl reset-failed layer-test-s3 2>/dev/null || true
if [[ "${1:-}" == --remove ]]; then
  rm -rf "${dir:?}"
  echo "removed"
  exit 0
fi
mkdir -p "$dir/scripts" "$dir/lib/backup"
install -m 644 "$here/fake-s3.ts" "$dir/scripts/fake-s3.ts"
install -m 644 "$here/s3.ts" "$dir/lib/backup/s3.ts"
systemd-run --quiet --unit=layer-test-s3 /opt/layer/runtime/bin/node --disable-warning=ExperimentalWarning "$dir/scripts/fake-s3.ts" 4999
for _ in $(seq 1 20); do
  curl -s -o /dev/null http://127.0.0.1:4999/ && break
  sleep 0.5
done
echo "fake S3 at http://127.0.0.1:4999"
