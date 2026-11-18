import type { Key } from "ink";

import type { AddForm } from "#interactive/add.ts";

export function movement(key: Key, pageSize: number) {
  if (key.upArrow) {
    return -1;
  }

  if (key.downArrow) {
    return 1;
  }

  if (key.pageUp) {
    return -pageSize;
  }

  if (key.pageDown) {
    return pageSize;
  }

  return 0;
}

/** Form navigation is separate from command shortcuts so typed spaces and letters stay text. */
export function formInput(form: AddForm, key: Key) {
  if (key.return && form.index === form.fields.length - 1) {
    return { form, submit: true };
  }

  if (key.tab || key.upArrow || key.downArrow || key.return) {
    const backwards = (key.tab && key.shift) || key.upArrow;
    const index = (form.index + (backwards ? -1 : 1) + form.fields.length) % form.fields.length;

    return { form: { ...form, index }, submit: false };
  }

  return { form, submit: false };
}
