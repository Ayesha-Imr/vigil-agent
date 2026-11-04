# Workers

TLC reached 192 states and 503 steps. The chart draws 23 states and 44 arrows.
The chart does not draw 184 steps that stay in one chart state.

## StoppedNeverRunsAgain breaks
The shortest path has 3 steps:
0. Queued
1. the 15 s pump starts it: Working: worker starting
2. the owner sends /stop: Stopped by owner: worker starting
3. the worker session is ready: Stopped by owner: turn in flight

## Rules that hold
NoDoubleRun, SlotLimit, StoppedRejectsInputs
