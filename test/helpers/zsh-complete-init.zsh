# Sourced inside the interactive zsh that test/helpers/zsh-complete.zsh drives. See that file.
PROMPT= RPROMPT= PS2=
# Wide enough that descriptions are not cut to fit the terminal.
stty columns 400 2> /dev/null
COLUMNS=400
unsetopt zle_bracketed_paste prompt_cr prompt_sp
# Either install path: a directory on fpath holding the script as _bb, or sourcing it after compinit.
[[ -n $BB_COMPLETION_FPATH ]] && fpath=($BB_COMPLETION_FPATH $fpath)
autoload -Uz compinit && compinit -u -D
zstyle ':completion:*' completer _complete
zstyle ':completion:*' verbose yes
bindkey '^I' complete-word
[[ -n $BB_COMPLETION_FPATH ]] || source $BB_COMPLETION_SCRIPT

# Print every candidate the completion system accepts instead of showing a menu.
compadd() {
  # Calls that only fill arrays (-O, -A, -D) are compsys talking to itself; pass them through.
  if [[ ${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then
    builtin compadd "$@"
    return
  fi
  typeset -a __hits __dscr
  local __name
  if (( $@[(I)-d] )); then
    __name=${@[$[${@[(i)-d]}+1]]}
    if [[ $__name == \(* ]]; then eval "__dscr=$__name"; else __dscr=("${(@P)__name}"); fi
  fi
  builtin compadd -A __hits -D __dscr "$@"
  local -A __pre
  zparseopts -E -A __pre P: p:
  local -i __i
  for (( __i = 1; __i <= $#__hits; __i++ )); do
    if (( $#__dscr >= __i )) && [[ $__dscr[__i] != $__hits[__i] ]]; then
      print -r -- "@@BB-HIT@@$IPREFIX$__pre[-P]$__pre[-p]$__hits[__i] -- ${${__dscr[__i]}##$__hits[__i] #(-- |)}@@BB-TIH@@"
    else
      print -r -- "@@BB-HIT@@$IPREFIX$__pre[-P]$__pre[-p]$__hits[__i]@@BB-TIH@@"
    fi
  done
  return 0
}
__bb_end() { print -r -- '@@BB-END@@' }
comppostfuncs=(__bb_end exit)
