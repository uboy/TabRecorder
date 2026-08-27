# 2026-04-25 microphone preflight errors

- Do not collapse all `getUserMedia` microphone failures into one generic "allow access" message.
- Distinguish permission denial, missing device, busy device, and cancellation in popup preflight flows.
- Clear cached microphone device selection when forced-mic preflight fails before recording starts.
