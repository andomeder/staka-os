# Vendored installer helpers for the live ISO configurator.
# Sourced from /root/helpers so runtime does not depend on the omarchy tree path.
_STAKA_HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$_STAKA_HELPERS_DIR/chroot.sh"
# shellcheck source=/dev/null
source "$_STAKA_HELPERS_DIR/presentation.sh"
# shellcheck source=/dev/null
source "$_STAKA_HELPERS_DIR/errors.sh"
# shellcheck source=/dev/null
source "$_STAKA_HELPERS_DIR/logging.sh"
unset _STAKA_HELPERS_DIR
