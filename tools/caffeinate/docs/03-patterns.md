# Common Patterns

## Keep Laptop Awake During Long Task

```bash
# Wrap the command directly — assertion ends when command finishes
caffeinate -dis -- rsync -avz /src/ remote:/dest/
caffeinate -di -- npm run build
caffeinate -i -- python train_model.py
```

## Keep Awake for Fixed Duration

```bash
# Using timeout flag
caffeinate -di -t 3600    # 1 hour

# Using sleep as the wrapped utility (more intuitive for scripts)
caffeinate -di sleep 3600
```

## Background Caffeinate for a Session

```bash
# Start in background, save PID for later cleanup
caffeinate -dis &
CAFF_PID=$!

# ... do work ...

# Clean up when done
kill $CAFF_PID
```

## Watch a Specific Process

```bash
# Start a build, then caffeinate until it finishes
make -j8 &
caffeinate -w $!

# Or find an already-running process
caffeinate -w $(pgrep -f "my-long-job")
```

## Scripting with Trap for Cleanup

```bash
#!/bin/bash
caffeinate -dis &
CAFF_PID=$!
trap "kill $CAFF_PID 2>/dev/null" EXIT

# Your long-running work here
echo "Running with caffeinate (PID $CAFF_PID)..."
# ...
```

## Checking if Caffeinate is Already Running

```bash
# Is caffeinate running?
pgrep -l caffeinate

# How many instances?
pgrep -c caffeinate

# What assertions does it hold?
pmset -g assertions | grep caffeinate
```

## Wake Display and Simulate Activity

```bash
# Wake the display (turns it on if off)
caffeinate -u -t 1

# Keep display on for a presentation
caffeinate -du -t 7200   # 2 hours
```
