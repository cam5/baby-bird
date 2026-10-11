# Ask the bash completion function what it would offer, without a human at the keyboard.
#
#   bash bash-complete.sh <completion-script> bb <word>...
#
# The last word is the one under the cursor (pass '' for "nothing typed yet"). Prints one candidate
# per line. This calls the function `complete -F` registered, with the variables readline would
# set; readline itself (how candidates are inserted, listed and sorted) is not involved.
source "$1" || exit 3
shift
COMP_WORDS=("$@")
COMP_CWORD=$((${#COMP_WORDS[@]} - 1))
COMP_LINE="$*"
COMP_POINT=${#COMP_LINE}
_bb
[ "${#COMPREPLY[@]}" -gt 0 ] && printf '%s\n' "${COMPREPLY[@]}"
exit 0
