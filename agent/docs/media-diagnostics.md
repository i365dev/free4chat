# Media relay diagnostic design (electric-audio investigation)

Status: **AWAITING DIAGNOSTIC EVIDENCE.** PR #148 Gate B remains open: a
human has not yet confirmed clean room playback. This document defines the
layered, secret-safe diagnostic plan for the residual distortion heard after
the Cloudflare SFU relay; it changes NO browser/SFU/RTP behavior.

Scope note: this file lives under `agent/` because it documents the Go
runtime's diagnostic surface; it touches no protected code and no release
docs.

## Reproduction conditions

- Fresh Free4Chat room; exactly one Go Agent (this PR), 0 Node runtimes, 0
  Pion child processes.
- Voice Reply granted (Voice ON, Meeting Notes OFF for isolation; a second
  pass with Stop -> Start re-grant).
- Human sends an addressed text turn; the agent replies audibly.
- Observed symptom: periodic robotic/stutter artifact ("电音/顿挫"), also
  reported on short single-sentence replies; historically also mid-reply
  truncation (now bounded by the chunk-queue fix).

## Proven-clean boundary (already established)

1. Raw Doubao TTS PCM (24 kHz mono S16LE) saved to WAV — operator: clean.
2. Full LOCAL loopback (real TTS -> Resample24To48 -> Opus encode -> RTP ->
   second in-process Pion peer -> Opus decode -> WAV) — operator: clean.
3. Encode round-trip energy match within ~0.8%.

Therefore the investigation focuses on: publisher health -> Cloudflare
activation -> browser negotiation -> browser RTP/jitter/concealment ->
human audibility. The SFU may rewrite RTP headers, so raw publisher vs
subscriber header equality is NEVER required.

## Layer 1 — Go publisher (this repo, safe aggregates only)

Fields (all counters/booleans; never SDP, payload, or raw IDs):

- codec: `opus`, clock rate: `48000`, channels: `mono` (encoder config),
  frame duration: `20ms` — constants, always loggable.
- `pcm_write_calls`, `pcm_input_bytes`, `opus_frames_written`,
  `outbound_rtp_packets`/`outbound_rtp_bytes` (only when Pion exposes them;
  never fabricated from WriteSample success).
- `paced_gap_count` (wall-clock pacing rebaselines >= 250 ms),
  `encode_errors`.
- `voice_bytes_received` / `voice_bytes_buffered` / `voice_bytes_drained`
  (bridge pending-PCM path).
- RTP seq/timestamp/SSRC/MID: only continuity/range summaries or a short
  hash if ever needed; raw values are never logged.
- Bootstrap stages: `session_created`, `gathered_offer_present`,
  `establish_attempted`, `establish_result_code` (bounded classes:
  ok / decoding_error / timeout / not_authorized / rate_limited /
  network_error / other).

## Layer 2 — Cloudflare (Worker-published, already safe)

- `publisher_session_lookup_ok`, `matching_track_found`,
  `matching_track_status`, `matching_track_has_mid`, `active`
  (`voice_publish_cloudflare_check`).
- `/tracks` + `/renegotiate` stage outcome and bounded error class only;
  never SDP, session/participant/track IDs, or response bodies.

## Layer 3 — Browser subscriber (existing diagnostics only)

- Existing PR #145 sequence: `track_published_received`,
  `subscribe_track_entered`, `tracks_new_result`, `remote_description_applied`,
  `answer_created`, `local_description_applied`, `renegotiate_ok`,
  `ontrack_fired`, `pending_session_match`, `stream_attached`.
- Aggregate WebRTC receiver stats to add (browser side, NOT in this PR):
  `packetsReceived`, `packetsLost`, `jitter`, `concealedSamples` /
  `concealmentEvents`, `audioOutputLevel`, `totalSamplesDuration`,
  `playout`/`underrun` equivalents. The browser flow itself stays unchanged
  unless a Go incompatibility is proven.

## Comparison gate (per experiment)

```
publisher healthy (Layer 1 counters, no gaps/errors)
  -> Cloudflare active (Layer 2 all-1 golden state)
  -> browser negotiation + ontrack (Layer 3 sequence complete)
  -> browser RTP/jitter/concealment aggregates (no runaway loss/PLC)
  -> HUMAN hears the reply cleanly
```

Each layer is recorded for every fresh-room run; the first failing layer
becomes the investigation target.

## Acceptance criteria

- Short sentence: human hears clean speech, no truncation.
- Long multi-sentence reply: complete and clean.
- Voice Stop -> Start re-grant: next turn still audible and clean.
- Until a human confirms: **AWAITING HUMAN AUDIBILITY CONFIRMATION** —
  never claim fixed from counters alone.

## Known separate observation

`sfu_datachannels_establish_decoding_error` appeared intermittently in
heavily-reused test rooms (many agent rejoin cycles). Now bounded into the
`establish_result_code` stage log. Fresh-room provenance is mandatory for
every experiment; a repro under clean provenance gets investigated against
the bootstrap stage log only.
