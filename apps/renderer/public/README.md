# Renderer public assets

This directory hosts static files served at the web root.

## Required: Porcupine model

The wake-word engine needs `porcupine_params.pv` placed here. Download it from
the Picovoice Porcupine repo (English, ~1.7 MB):

```
https://github.com/Picovoice/porcupine/raw/master/lib/common/porcupine_params.pv
```

…and save it as `apps/renderer/public/porcupine_params.pv`.

For non-English wake words use the matching `porcupine_params_<lang>.pv` and
update `/src/lib/audio-bridge.ts` accordingly.
