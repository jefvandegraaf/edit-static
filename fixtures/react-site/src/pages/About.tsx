import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

const About = () => (
  <>
    <Navbar />
    <section className="hero">
      <h1>About us</h1>
      <p className="lead">Two designers and a developer who got tired of slow, bloated websites.</p>
    </section>
    <Footer />
  </>
);

export default About;
