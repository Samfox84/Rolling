#!/usr/bin/env node
// Test stand-in for whisper.cpp's whisper-cli: same arguments, same JSON output shape.
// Writes one "sentence" per 5 seconds of audio, plus one hallucination line that Rolling must filter out.
'use strict';
const fs = require('fs');
const a = process.argv.slice(2), get = f => a[a.indexOf(f) + 1];
const wav = get('-f'), prefix = get('-of');
if (!wav || !prefix || !a.includes('-oj')) { process.stderr.write('fake-whisper: missing -f / -of / -oj\n'); process.exit(2); }
// tests can make the engine fail (like a broken install) by creating this file
if (process.env.FAKE_WHISPER_FAIL_FLAG && fs.existsSync(process.env.FAKE_WHISPER_FAIL_FLAG)) { process.stderr.write('error: failed to load model\n'); process.exit(3); }
const secs = (fs.statSync(wav).size - 44) / 32000; // 16 kHz 16-bit mono
const transcription = [];
for (let s = 0; s + 1 < secs; s += 5) transcription.push({ offsets: { from: Math.round(s * 1000), to: Math.round(Math.min(secs, s + 4.5) * 1000) }, text: ` Sentence at ${s} seconds.` });
transcription.push({ offsets: { from: 0, to: 500 }, text: ' Thank you.' }); // classic whisper hallucination
fs.writeFileSync(prefix + '.json', JSON.stringify({ transcription }));
