// A webhook receiver that writes a line to a file for each request (the
// signature header, a tab, the body on one line), for the browser tour to
// check what Forms posted:
//   node hook-sink.ts <port> <file>
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [port = "2626", file = "/tmp/hook-sink.log"] = process.argv.slice(2);
writeFileSync(file, "");
createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c: string) => (body += c));
  req.on("end", () => {
    appendFileSync(file, `${req.headers["x-forms-signature"] ?? ""}\t${body.replace(/\n/g, " ")}\n`);
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`webhook sink on 127.0.0.1:${port}, writing to ${file}`));
