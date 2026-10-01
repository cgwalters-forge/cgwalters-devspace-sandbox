# egress-demo: The sandbox gets out only through the proxy, to allowed hosts
# shellcheck shell=bash
# The job allows api.github.com alone (sandbox.network.allow).
fail=0
# expect NAME ok|fail COMMAND...: COMMAND must succeed or fail.
expect() {
  local name=$1 want=$2 got=fail
  shift 2
  if "$@" >/dev/null 2>&1; then got=ok; fi
  if [ "$got" = "$want" ]; then
    echo "as expected: $name ($got)"
  else
    echo "WRONG: $name: wanted $want, got $got"
    fail=1
  fi
}
c=(curl -sSf --max-time 20 -o /dev/null)
expect "an allowed host, through the proxy" ok "${c[@]}" https://api.github.com/zen
expect "another host, through the proxy" fail "${c[@]}" https://example.com/
expect "plain http to another host, through the proxy" fail "${c[@]}" http://example.com/
expect "an IP literal, through the proxy" fail "${c[@]}" -k https://140.82.112.6/
expect "an allowed host, directly" fail "${c[@]}" --noproxy '*' https://api.github.com/zen
expect "an IP address, directly" fail "${c[@]}" --noproxy '*' -k https://140.82.112.6/
expect "the cloud metadata service" fail "${c[@]}" --noproxy '*' --max-time 5 http://169.254.169.254/
expect "name resolution through libc" fail getent ahosts github.com
expect "systemd-resolved over D-Bus or varlink" fail timeout 20 resolvectl query github.com
expect "the local DNS stub" fail dig +time=3 +tries=1 @127.0.0.53 github.com
expect "a public DNS server over UDP" fail dig +time=3 +tries=1 @8.8.8.8 github.com
expect "a public DNS server over TCP" fail dig +tcp +time=3 +tries=1 @8.8.8.8 github.com
exit "$fail"
