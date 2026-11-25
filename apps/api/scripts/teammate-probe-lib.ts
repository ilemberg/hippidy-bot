// The pure parts of the teammate probe (slice 2.1, part A): the script the session runs, how
// its output is read, and what the findings mean for the start rule (G18). Kept apart from
// `teammate-probe.ts` so they can be tested without Anthropic or a network.

/** The prefix every line of the sandbox script's report starts with. */
export const MARK = "PROBE";

/** Public hosts the script tries, to see which the teammate's environment lets through. */
export const HTTP_TARGETS = [
  "https://registry.npmjs.org/",
  "https://pypi.org/simple/",
  "https://github.com/",
  "https://api.github.com/",
  "https://raw.githubusercontent.com/",
  "https://codeload.github.com/",
  "https://nodejs.org/dist/",
  "https://example.com/",
] as const;

/**
 * The script the session runs with its bash tool, exactly as given. Each check prints one line,
 * `PROBE <check> <ok|fail> <detail>`, so the report is read from the tool's output, not from
 * what the agent says about it. `branch` is the name a push is tried under; it must be refused.
 */
export function sandboxScript(branch: string): string {
  const http = HTTP_TARGETS.map(
    (url) =>
      `code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' '${url}'); rc=$?; ` +
      `probe "http ${url}" "$([ "$rc" = 0 ] && [ "$code" -ge 200 ] && [ "$code" -lt 400 ] && echo ok || echo fail)" "code=$code curl_exit=$rc"`,
  ).join("\n");
  return `set +e
probe() { printf '${MARK} %s %s %s\\n' "$1" "$2" "$(printf '%s' "$3" | tr '\\n' ' ' | cut -c1-300)"; }
tail_err() { tr '\\n' ' ' < /tmp/probe-err | sed -E 's#//[^/@ ]*@#//***@#g' | cut -c1-300; }

REPO=""
for dir in $(find / -maxdepth 5 -type d -name .git 2>/dev/null | grep -v '^/proc' | head -20); do
  root=$(dirname "$dir")
  if [ -f "$root/CLAUDE.md" ] && grep -q hippidy "$root/CLAUDE.md"; then REPO="$root"; break; fi
done
if [ -z "$REPO" ]; then probe mount fail "no clone of the repository found"; else
  probe mount ok "path=$REPO head=$(git -C "$REPO" rev-parse HEAD 2>/dev/null) branch=$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  probe remote ok "$(git -C "$REPO" remote -v | head -1 | sed -E 's#//[^/@ ]*@#//***@#g')"

  timeout 90 git -C "$REPO" fetch --quiet origin main 2>/tmp/probe-err
  rc=$?; probe fetch-main "$([ $rc = 0 ] && echo ok || echo fail)" "exit=$rc $(tail_err)"

  timeout 90 git -C "$REPO" fetch --quiet origin '+refs/pull/*/head:refs/remotes/probe-pr/*' 2>/tmp/probe-err
  rc=$?; count=$(git -C "$REPO" for-each-ref refs/remotes/probe-pr | wc -l)
  probe fetch-pull-refs "$([ $rc = 0 ] && [ "$count" -gt 0 ] && echo ok || echo fail)" "exit=$rc refs=$count $(tail_err)"

  out=$(timeout 90 git -C "$REPO" ls-remote origin 2>/tmp/probe-err); rc=$?
  probe ls-remote "$([ $rc = 0 ] && echo ok || echo fail)" "exit=$rc refs=$(printf '%s' "$out" | grep -c .) pull_refs=$(printf '%s' "$out" | grep -c 'refs/pull/') $(tail_err)"

  git -C "$REPO" -c user.name=probe -c user.email=probe@example.invalid commit --quiet --allow-empty -m "teammate probe: this push must be refused" 2>/tmp/probe-err
  timeout 90 git -C "$REPO" push --quiet origin "HEAD:refs/heads/${branch}" 2>/tmp/probe-err
  rc=$?; probe push "$([ $rc = 0 ] && echo ok || echo fail)" "exit=$rc $(tail_err)"
fi

rm -rf /tmp/probe-clone
timeout 90 git clone --quiet --depth 1 https://github.com/octocat/Hello-World.git /tmp/probe-clone 2>/tmp/probe-err
rc=$?; probe clone-other-repo "$([ $rc = 0 ] && echo ok || echo fail)" "exit=$rc $(tail_err)"

${http}

out=$(timeout 60 npm view left-pad version 2>/tmp/probe-err); rc=$?
probe npm "$([ $rc = 0 ] && echo ok || echo fail)" "exit=$rc version=$out $(tail_err)"

probe proxy-variables ok "$(env | cut -d= -f1 | grep -i proxy | sort | tr '\\n' ' ')"
probe done ok ""
`;
}

export interface ProbeLine {
  outcome: "ok" | "fail";
  detail: string;
}

/** Reads the script's report out of the bash tool's output, one entry per check. */
export function parseProbeOutput(text: string): Map<string, ProbeLine> {
  const results = new Map<string, ProbeLine>();
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${MARK} `)) continue;
    // `http <url>` is the one check whose name has a space in it.
    const match = /^PROBE ((?:http \S+)|\S+) (ok|fail) ?(.*)$/.exec(line.trimEnd());
    if (match === null) continue;
    const [, name, outcome, detail] = match;
    if (name === undefined || detail === undefined) continue;
    results.set(name, { outcome: outcome === "ok" ? "ok" : "fail", detail });
  }
  return results;
}

/** A value from a `key=value` detail, such as `head` from `path=/x head=abc branch=main`. */
export function detailValue(detail: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${key}=(\\S*)`).exec(detail);
  return match?.[1];
}

export interface Verdict {
  /** The session cannot publish: no push, and no host it could publish to. */
  cannotPublish: boolean;
  /** The session can read refs other than the mounted `main` (a fork's pull request, say). */
  readsOtherRefs: boolean;
  /** Hosts the environment let through. */
  reachableHosts: string[];
  /** What the findings mean for G18, in a sentence or two. */
  g18: string;
  /** Findings that contradict the plan in `slice-2-1.md`, each a sentence. */
  problems: string[];
}

/** What the checks mean for rule 1 of slice 2.1 and the start rule (G18). */
export function judge(results: ReadonlyMap<string, ProbeLine>, mainSha?: string): Verdict {
  const ok = (name: string) => results.get(name)?.outcome === "ok";
  const problems: string[] = [];

  if (!results.has("done")) problems.push("The script did not run to its end.");
  if (!ok("mount")) problems.push("The repository was not found mounted in the session.");
  const head = detailValue(results.get("mount")?.detail ?? "", "head");
  if (ok("mount") && mainSha !== undefined && head !== mainSha)
    problems.push(`The mounted HEAD (${head ?? "none"}) is not main (${mainSha}).`);

  const reachableHosts = HTTP_TARGETS.filter((url) => ok(`http ${url}`)).map(
    (url) => new URL(url).host,
  );
  if (ok("push")) problems.push("A push from the session was accepted: rule 1 does not hold.");
  if (ok("npm")) problems.push("npm reached a registry although package managers are off.");
  if (reachableHosts.length > 0)
    problems.push(`The environment let through: ${reachableHosts.join(", ")}.`);

  const readsOtherRefs = ok("fetch-pull-refs") || ok("clone-other-repo");
  const cannotPublish = !ok("push");
  const g18 = readsOtherRefs
    ? "The teammate can read refs other than main with git, which the start rule cannot see " +
      "from tool calls alone. Count every git fetch, pull or clone in its shell calls as untrusted, " +
      "or have every brief started by a person."
    : "The teammate cannot read refs other than main, so the start rule can rest on its " +
      "Atlassian tool calls: only briefs written after one need a person to start them.";
  return { cannotPublish, readsOtherRefs, reachableHosts, g18, problems };
}
