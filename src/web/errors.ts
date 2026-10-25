// The two failures a caller can fix: bad input (400) and a control already running (409). Everything else is a 500.
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export class SimBusy extends Error {
  constructor(message = 'a simulation control is already running; try again when it finishes') {
    super(message);
    this.name = 'SimBusy';
  }
}
