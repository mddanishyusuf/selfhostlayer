// An SMTP server that takes every message and writes a line for each to a file
// (recipients, a tab, the subject), for the browser tour to check what Email sent:
//   node smtp-sink.ts <port> <file>
import { appendFileSync, writeFileSync } from "node:fs";
import { fakeSmtp } from "./fake-smtp.ts";

const [port = "2525", file = "/tmp/smtp-sink.log"] = process.argv.slice(2);
writeFileSync(file, "");
const sink = await fakeSmtp({ security: "none", port: Number(port) });
let seen = 0;
setInterval(() => {
  for (; seen < sink.received.length; seen++) {
    const m = sink.received[seen]!;
    const subject = /^Subject: (.*)$/m.exec(m.data)?.[1] ?? "";
    appendFileSync(file, `${m.to.join(",")}\t${subject}\n`);
  }
}, 200);
console.log(`SMTP sink on 127.0.0.1:${sink.port}, writing to ${file}`);
