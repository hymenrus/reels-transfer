export function captionForAccount(draft, accountId) {
  const accountCaptions = draft?.captionsByAccount;
  if (accountId && accountCaptions && Object.hasOwn(accountCaptions, accountId)) {
    return typeof accountCaptions[accountId] === 'string' ? accountCaptions[accountId] : '';
  }
  if (accountId && accountCaptions && Object.keys(accountCaptions).length > 0) return '';
  return typeof draft?.caption === 'string' ? draft.caption : '';
}

export function setCaptionForAccount(draft, accountId, caption) {
  const next = { ...(draft && typeof draft === 'object' ? draft : {}), caption };
  if (accountId) {
    next.captionsByAccount = {
      ...(draft?.captionsByAccount && typeof draft.captionsByAccount === 'object' ? draft.captionsByAccount : {}),
      [accountId]: caption,
    };
  }
  return next;
}

export function hasReelDraftContent(draft) {
  const accountCaptions = Object.values(draft?.captionsByAccount || {}).some((value) => typeof value === 'string' && value.trim());
  return Boolean(String(draft?.urls || '').trim() || String(draft?.caption || '').trim() || accountCaptions);
}

export function validateCaptionTemplate(name, caption) {
  const cleanName = String(name ?? '').trim();
  const cleanCaption = String(caption ?? '').trim();
  if (!cleanName) return { ok: false, reason: 'name_required' };
  if (cleanName.length > 60) return { ok: false, reason: 'name_too_long' };
  if (!cleanCaption) return { ok: false, reason: 'caption_required' };
  if (cleanCaption.length > 2200) return { ok: false, reason: 'caption_too_long' };
  return { ok: true, name: cleanName, caption: cleanCaption };
}
