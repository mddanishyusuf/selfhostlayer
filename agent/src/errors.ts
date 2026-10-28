/**
 * An expected failure with a stable code the panel can branch on
 * (not_found, conflict, ...). Its message is shown to the user, so it must
 * not include command output or secrets.
 */
export class ActionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
  }
}
