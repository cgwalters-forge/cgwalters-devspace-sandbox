# Agent instructions

The development-runner workflow intentionally remains `in_progress` as a
keepalive for the requested duration. After `cargo devspace start` returns, do
not wait for the workflow or its keepalive job to complete before connecting.
`cargo devspace start` returns once ordinary OpenSSH is ready, and
`cargo devspace ssh RUN_ID` also polls until it is.
