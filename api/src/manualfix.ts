// SPDX-License-Identifier: GPL-2.0-or-later
// 公式の直しが、お店のファイルにすでに手で入っているかを見分ける。
// 改造の多いお店では、制作会社が公式の直しの差分を手で当てていることがある。その場合、ファイルは公式と違う(改造がある)が、
// 直しそのものは入っている。差分(GitHub の compare の patch)の「足した行」がそろい、「消した行」が残っていなければ、入っているとみなす。
// 迷うとき(差分が無い・意味のある行が無い・一部だけ)は「入っていない」と答える。そのときは今までどおり改造として上書きしない(安全な側に倒す)。

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
// 括弧だけ・短すぎる行は、ほかの場所にもよくあるので手がかりにしない
const meaningful = (s: string) => s.length >= 6 && /[A-Za-z0-9_$]/.test(s);

export interface ManualFixCheck {
  applied: boolean;
  added_lines: number;
  removed_lines: number;
  missing_added: number; // お店に無い「足した行」の数
  remaining_removed: number; // お店に残っている「消した行」の数
}

export function fixAlreadyIn(patch: string | undefined, shopContent: string): ManualFixCheck {
  const res: ManualFixCheck = { applied: false, added_lines: 0, removed_lines: 0, missing_added: 0, remaining_removed: 0 };
  if (!patch) return res;
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) { const t = norm(line.slice(1)); if (meaningful(t)) added.push(t); }
    else if (line.startsWith("-")) { const t = norm(line.slice(1)); if (meaningful(t)) removed.push(t); }
  }
  const addedSet = new Set(added);
  // 動かしただけの行(消して別の場所に足した)は、消した行として数えない
  const removedOnly = removed.filter((t) => !addedSet.has(t));
  const shop = new Set(shopContent.split(/\r?\n/).map(norm));
  res.added_lines = added.length;
  res.removed_lines = removedOnly.length;
  res.missing_added = added.filter((t) => !shop.has(t)).length;
  res.remaining_removed = removedOnly.filter((t) => shop.has(t)).length;
  res.applied = added.length + removedOnly.length > 0 && res.missing_added === 0 && res.remaining_removed === 0;
  return res;
}
