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

export function tagsForAccount(draft, accountId) {
  const accountTags = draft?.tagsByAccount;
  if (accountId && accountTags && Object.hasOwn(accountTags, accountId)) {
    return typeof accountTags[accountId] === 'string' ? accountTags[accountId] : '';
  }
  if (accountId && accountTags && Object.keys(accountTags).length > 0) return '';
  return typeof draft?.tags === 'string' ? draft.tags : '';
}

export function setTagsForAccount(draft, accountId, tags) {
  const next = { ...(draft && typeof draft === 'object' ? draft : {}), tags };
  if (accountId) {
    next.tagsByAccount = {
      ...(draft?.tagsByAccount && typeof draft.tagsByAccount === 'object' ? draft.tagsByAccount : {}),
      [accountId]: tags,
    };
  }
  return next;
}

export function hasReelDraftContent(draft) {
  const accountCaptions = Object.values(draft?.captionsByAccount || {}).some((value) => typeof value === 'string' && value.trim());
  const accountTags = Object.values(draft?.tagsByAccount || {}).some((value) => typeof value === 'string' && value.trim());
  return Boolean(String(draft?.urls || '').trim() || String(draft?.caption || '').trim() || String(draft?.tags || '').trim() || accountCaptions || accountTags);
}

export function composeCaptionWithTags(caption, tags) {
  const base = String(caption ?? '').trim();
  const suffix = String(tags ?? '').trim();
  if (!suffix) return base;
  if (!base) return suffix;
  if (base.toLocaleLowerCase('tr-TR').endsWith(suffix.toLocaleLowerCase('tr-TR'))) return base;
  return `${base}\n\n${suffix}`;
}

export function captionForReelUrl(itemCaption, sharedCaption, _sharedTags, selectedTemplate = null) {
  const caption = selectedTemplate ? selectedTemplate.caption : (sharedCaption || itemCaption);
  return String(caption ?? '').trim();
}

export function validateCaptionTemplate(name, caption, tags = '') {
  const cleanName = String(name ?? '').trim();
  const cleanCaption = String(caption ?? '').trim();
  const cleanTags = String(tags ?? '').trim();
  if (!cleanName) return { ok: false, reason: 'name_required' };
  if (cleanName.length > 60) return { ok: false, reason: 'name_too_long' };
  if (!cleanCaption && !cleanTags) return { ok: false, reason: 'caption_required' };
  if (cleanCaption.length > 2200) return { ok: false, reason: 'caption_too_long' };
  if (cleanTags.length > 2200) return { ok: false, reason: 'tags_too_long' };
  if (composeCaptionWithTags(cleanCaption, cleanTags).length > 2200) return { ok: false, reason: 'combined_too_long' };
  return { ok: true, name: cleanName, caption: cleanCaption, tags: cleanTags };
}
