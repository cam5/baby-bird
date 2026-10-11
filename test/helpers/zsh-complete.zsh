#!/bin/zsh -f
# Ask a real, interactive zsh what it would complete, without a human at the keyboard.
#
#   zsh -f zsh-complete.zsh <completion-script> <command line up to the cursor>
#
# With BB_COMPLETION_FPATH set to a directory that holds the script as `_bb`, the script argument is
# ignored and the completion is autoloaded from fpath instead of sourced.
#
# Starts `zsh -f -i` on a pseudo-terminal, has it source zsh-complete-init.zsh (compinit, then the
# completion script), types the command line and presses Tab. The init file wraps `compadd`, so
# every candidate the completion system accepts, after its own prefix matching, is printed as
# "candidate" or "candidate -- description", one per line. This is the technique of
# zsh-capture-completion. It exercises the real compsys (_describe, _wanted, compset), but not
# what a person sees: menus, colors, list layout and key bindings are not covered.

zmodload zsh/zpty || exit 3
export BB_COMPLETION_SCRIPT=$1
typeset line=$2 out chunk
integer idle=0

zpty -b bbz zsh -f -i || exit 3
zpty -w bbz "source ${(q)0:A:h}/zsh-complete-init.zsh"
zpty -w -n bbz "$line"$'\t'

# Give up after ten seconds without the end marker.
while (( idle < 200 )) && [[ $out != *@@BB-END@@* ]]; do
  if zpty -r bbz chunk; then
    out+=$chunk
  else
    zpty -t bbz || break
    sleep 0.05
    (( idle += 1 ))
  fi
done
zpty -d bbz 2> /dev/null

out=${out//$'\r'/}
if [[ $out != *@@BB-END@@* ]]; then
  print -u2 -r -- "no completion output; the shell said: ${(qqqq)out}"
  exit 4
fi
# Candidates are wrapped in markers because zle may redraw the command line in between them.
while [[ $out == *@@BB-HIT@@*@@BB-TIH@@* ]]; do
  out=${out#*@@BB-HIT@@}
  print -r -- ${out%%@@BB-TIH@@*}
  out=${out#*@@BB-TIH@@}
done
