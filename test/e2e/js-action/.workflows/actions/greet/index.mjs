// A JavaScript action: bespoke logic the engine never sees. Reads its typed
// input from the INPUT_<NAME> env var and writes a declared output to the
// $WORK_OUTPUT file (the same ABI a `run:` step uses).
import { appendFileSync } from "node:fs";

const name = process.env.INPUT_NAME ?? "world";
appendFileSync(process.env.WORK_OUTPUT, `greeting=hello, ${name}\n`);
