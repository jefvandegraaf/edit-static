import { Button } from "@/components/ui/button";
import { ArrowRight } from "./Icons";

const Hero = () => {
  return (
    <section className="hero">
      <h1 className="text-5xl font-bold">
        Websites that
        <span className="block text-primary">sell while you sleep</span>
      </h1>
      <p className="lead">
        We build fast, beautiful sites for small businesses. No templates, no
        monthly fees, no nonsense.
      </p>
      <Button size="lg">
        Get started <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
      <Button variant="outline">See our work</Button>
    </section>
  );
};

export default Hero;
