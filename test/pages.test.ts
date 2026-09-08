import assert from "node:assert/strict";
import { test } from "node:test";
import { landingPage, joinPage } from "../src/pages.js";

test("public pages keep the real connection requirement and Pro availability", () => {
  const home = landingPage([], "https://host.example", false);
  assert.doesNotMatch(home, /href="\/pro"/);
  assert.match(home, /Your first site belongs here/);
  assert.match(landingPage([], "https://host.example", true), /href="\/pro"/);
  const guide = joinPage("https://host.example");
  assert.match(guide, /publishing requires an approved agent credential/);
  assert.doesNotMatch(guide, /No account required|24.hour/);
});

test("agent prompts escape a host value before embedding it in HTML", () => {
  for (const render of [joinPage, (url: string) => landingPage([], url)]) {
    const html = render('https://example.com/</pre><script>alert("host")</script>');
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert/);
    assert.match(html, /id="copy-prompt"/);
  }
});
