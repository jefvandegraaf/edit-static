import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const links = [
  { name: "Work", href: "/#work" },
  { name: "Services", href: "/#services" },
  { name: "About", href: "/about" },
];

export const Navbar = () => (
  <nav>
    <Link to="/" className="logo">Acme Studio</Link>
    <ul>
      {links.map((link) => (
        <li key={link.name}>
          <Link to={link.href}>{link.name}</Link>
        </li>
      ))}
    </ul>
    <Button>Get started</Button>
  </nav>
);
