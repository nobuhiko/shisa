// SPDX-License-Identifier: GPL-2.0-or-later
// 報告を受け取る前の、一度だけの見直し。
// 言語の実行環境(PHP など、Shisa が入れ替えられないもの)の弱点を、暫定策だけで「防いでいる(mitigated)」とした報告に、
// 実行環境そのものの入れ替えを頼む項目(needs_human、宛先はサーバー会社)が無ければ、書き直してもらう。まとめに書くだけでは、店主の作業の一覧に出ないため
export function reportGaps(report: any): string[] {
  const findings: any[] = Array.isArray(report?.findings) ? report.findings : [];
  const gaps: string[] = [];
  const runtimeMitigated = findings.filter((f) => f?.category === "php" && f?.status === "mitigated");
  const askedHost = findings.some((f) => f?.status === "needs_human" && (f?.to === "server_company" || (f?.category === "php" && f?.to !== "developer")));
  if (runtimeMitigated.length && !askedHost) {
    gaps.push(
      `The runtime finding(s) ${runtimeMitigated.map((f) => JSON.stringify(String(f.title ?? "")).slice(0, 80)).join(", ")} are only mitigated by interim settings, and the runtime itself can only be replaced on the hosting side. Add a separate finding (category php, status needs_human, to server_company) that asks for the same runtime version line with the official fixes, with a ready-to-send request in "requests", and say how the shop is protected meanwhile. Mentioning it only in the summary is not enough.`,
    );
  }
  return gaps;
}
