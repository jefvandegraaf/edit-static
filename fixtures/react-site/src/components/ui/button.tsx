import { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline";
  size?: "default" | "lg";
}

export const Button = ({ variant = "default", size = "default", className, ...props }: ButtonProps) => (
  <button className={cn("btn", variant === "outline" && "outline", size === "lg" && "lg", className)} {...props} />
);
