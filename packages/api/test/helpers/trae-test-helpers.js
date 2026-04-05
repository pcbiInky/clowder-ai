export function emitTraeJson(proc, payload, exitCode = 0) {
  proc.stdout.write(JSON.stringify(payload));
  proc.stdout.end();
  process.nextTick(() => proc._emitter.emit('exit', exitCode, null));
}

export function emitTraeStdout(proc, text, exitCode = 0) {
  proc.stdout.write(text);
  proc.stdout.end();
  process.nextTick(() => proc._emitter.emit('exit', exitCode, null));
}
