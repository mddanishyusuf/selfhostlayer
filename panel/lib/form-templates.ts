// Starting points for a new form: a schema each, edited freely afterwards.
import type { Field, Schema } from "./form-schema";

const f = (id: string, type: Field["type"], label: string, more: Partial<Field> = {}): Field => ({ id, type, label, help: "", required: false, placeholder: "", options: [], min: null, max: null, maxLength: null, param: "", accept: "", showIf: null, ...more });

const base = (fields: Field[], more: Partial<Schema> = {}): Schema => ({
  description: "",
  layout: "classic",
  theme: { accent: "#4f46e5", mode: "light", logo: "" },
  button: "Submit",
  thanks: { title: "Thanks!", message: "Your answers were sent.", redirect: "" },
  fields,
  ...more,
});

export const TEMPLATES: { id: string; name: string; description: string; schema: () => Schema }[] = [
  { id: "blank", name: "Blank", description: "One question to start from", schema: () => base([f("q1", "short_text", "Your first question", { required: true })]) },
  {
    id: "contact",
    name: "Contact",
    description: "Name, email and a message",
    schema: () => base([f("name", "short_text", "Your name", { required: true }), f("email", "email", "Your email", { required: true, placeholder: "you@example.com" }), f("message", "long_text", "How can we help?", { required: true })], { button: "Send", thanks: { title: "Thanks!", message: "We'll get back to you soon.", redirect: "" } }),
  },
  {
    id: "feedback",
    name: "Product feedback",
    description: "A rating, NPS and what to improve, one question at a time",
    schema: () =>
      base(
        [
          f("stars", "rating", "How would you rate us?", { required: true, max: 5 }),
          f("nps", "scale", "How likely are you to recommend us to a friend?", { required: true, help: "0 is not at all, 10 is very likely" }),
          f("better", "long_text", "What would make it better?", { showIf: { field: "stars", op: "lt", value: "4" } }),
          f("love", "long_text", "What do you like most?", { showIf: { field: "stars", op: "gt", value: "3" } }),
          f("email", "email", "Your email, if we may follow up"),
        ],
        { layout: "conversational", button: "Send feedback" },
      ),
  },
  {
    id: "signup",
    name: "Event signup",
    description: "Who's coming, and how many",
    schema: () =>
      base([
        f("name", "short_text", "Your name", { required: true }),
        f("email", "email", "Your email", { required: true }),
        f("guests", "number", "How many are coming, you included?", { required: true, min: 1, max: 10 }),
        f("diet", "multi", "Anything we should know for food?", { options: ["Vegetarian", "Vegan", "Gluten-free", "None"] }),
        f("source", "hidden", "Where they came from", { param: "ref" }),
      ], { button: "Sign me up" }),
  },
  {
    id: "application",
    name: "Job application",
    description: "Details, a CV upload and links, in two steps",
    schema: () =>
      base([
        f("name", "short_text", "Full name", { required: true }),
        f("email", "email", "Email", { required: true }),
        f("role", "dropdown", "Which role?", { required: true, options: ["Engineer", "Designer", "Marketing"] }),
        f("step2", "page_break", ""),
        f("cv", "file", "Your CV", { required: true, accept: ".pdf,.doc,.docx" }),
        f("site", "url", "A link to your work"),
        f("why", "long_text", "Why us?", { maxLength: 2000 }),
      ], { button: "Apply" }),
  },
];
