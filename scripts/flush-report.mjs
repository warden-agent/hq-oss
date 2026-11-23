// Preloaded into every test process by own-tmp.mjs (`--import`), for Bug 291. With --test-force-exit a test file's process calls
// process.exit() as soon as its report has been handed to its stdout, the pipe to the runner. node writes to a pipe without
// waiting, so when the pipe is full (64 KB: a file with many quick tests, a runner too busy to read) the rest is still queued in
// the process, and the exit throws it away: the file's last tests and its end-of-file summary never reach the runner, the exit
// code is 0, and the run says OK with tests missing (node 25.4 on a Mac and 25.9 on Linux, 2026-11-19: 7 of 20 unit runs in
// Docker under load). Here a test file's output waits until it is written, so nothing is queued when the process ends.
// `_handle.setBlocking` is node's own (it does the same for stdout on Windows). Should it go away, this does nothing, and
// whole-files.mjs still fails the run that lost a file's end.
if (process.env.NODE_TEST_CONTEXT) for (const s of [process.stdout, process.stderr]) s._handle?.setBlocking?.(true) // a test file's process, not the runner
