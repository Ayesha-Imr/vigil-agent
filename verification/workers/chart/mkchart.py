# Inputs for the pstack /statechart chart of Workers.tla (output: ../chart.mmd).
# Usage: python3 mkchart.py ../Workers.tla <scratch>/Workers.tla, then run /statechart on that copy
# with --config Chart.cfg --view view.mjs. See .claude/skills/verify-worker-slots/SKILL.md.
# Chart copy of verification/workers/Workers.tla: the Base variant without the V parameter
# (plain step names) and without comments (this TLC build exports comments as CDATA,
# which the statechart script's XML reader does not parse).
import re, sys
s = open(sys.argv[1]).read()
s = re.sub(r'\\\*[^\n]*', '', s)                 # line comments first: they contain "(*"
s = re.sub(r'\(\*.*?\*\)', '', s, flags=re.S)     # then block comments
s = re.sub(r'\(V\)', '', s); s = re.sub(r'\(V, ', '(', s); s = re.sub(r'\bV\.', 'Base.', s)
s = s.replace("Next == NextWith(Base)\nSpec == SpecWith(Base)", "Next == NextWith\nSpec == SpecWith")
s = re.sub(r'Fixed ==.*?(?=\n-{10,})', '', s, flags=re.S)
s = s.replace("RunnableIn(Base, t,", "RunnableIn(t,")
open(sys.argv[2], 'w').write(s)
# FiniteSets pulls in Sequences, whose comments contain "<<" and also break that XML reader:
s = open(sys.argv[2]).read()
s = s.replace("EXTENDS Integers, Sequences, FiniteSets, TLC", "EXTENDS Integers\nRECURSIVE Cardinality(_)\nCardinality(S) == IF S = {} THEN 0 ELSE LET x == CHOOSE y \\in S : TRUE IN 1 + Cardinality(S \\ {x})")
s = s.replace("Len(TicketOrder)", "NT")
open(sys.argv[2], 'w').write(s)
