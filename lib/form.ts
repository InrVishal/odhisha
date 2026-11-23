/**
 * Reads one field from a server action's form argument. A crafted request
 * can send anything in place of the form (a number, a string, null), so
 * anything but real FormData reads as "field missing", which the action's
 * own validation then rejects, instead of a 500.
 */
export function formField(form: unknown, name: string): FormDataEntryValue | null {
  return form instanceof FormData ? form.get(name) : null;
}
