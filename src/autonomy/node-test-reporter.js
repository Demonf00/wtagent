import { Transform } from "node:stream";

// Trusted reporter loaded by the restricted verifier, never by a task plan.
// Node emits a synthetic passing test for a file with no registered tests.
// That file-wrapper event lacks entryFile and must NOT count as a test.
export default class BoundedTestReporter extends Transform {
  constructor() {
    super({ writableObjectMode: true });
    this.counts = {
      schema: 1,
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      todo: 0,
    };
    this.invalid = false;
  }

  _transform(event, _encoding, done) {
    const { type, data } = event ?? {};
    if ((type === "test:pass" || type === "test:fail")
      && typeof data?.entryFile === "string" && data.entryFile.length > 0) {
      const c = this.counts;
      c.tests += 1;
      if (c.tests > 10000) this.invalid = true;
      if (data.skip) c.skipped += 1;
      else if (data.todo) c.todo += 1;
      else if (type === "test:pass") c.passed += 1;
      else if (data.details?.error?.failureType === "cancelledByParent") c.cancelled += 1;
      else c.failed += 1;
    }
    done();
  }

  _flush(done) {
    if (this.invalid) {
      this.push('{"schema":0}\n');
    } else {
      this.push(`${JSON.stringify(this.counts)}\n`);
    }
    done();
  }
}
