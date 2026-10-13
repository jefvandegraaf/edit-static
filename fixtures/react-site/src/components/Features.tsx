const features = [
  {
    title: "Lightning fast",
    description: "Every page loads in under a second, even on a bad connection.",
  },
  {
    title: "Built to convert",
    description: 'Clear calls to action, so visitors know what to do next.',
  },
  {
    title: "Yours to edit",
    description: `Change any word yourself, right on the page.`,
  },
];

export const Features = () => (
  <section id="services" className="grid">
    {features.map((f) => (
      <div key={f.title} className="card">
        <h3>{f.title}</h3>
        <p>{f.description}</p>
      </div>
    ))}
  </section>
);
