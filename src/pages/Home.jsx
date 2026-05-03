import React from "react";
import { motion } from "framer-motion";

export default function Home() {
  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="flex items-center gap-[2px]"
      >
        <Cursor />
        <p className="font-serif text-muted-foreground/40 text-[clamp(1.25rem,4vw,2.5rem)] italic select-none tracking-tight">
          Begin your legacy.
        </p>
      </motion.div>
    </div>
  );
}

function Cursor() {
  return (
    <motion.span
      className="inline-block w-[1px] h-[clamp(1.5rem,4.5vw,3rem)] bg-foreground/80 origin-center"
      animate={{ opacity: [1, 0.15, 1] }}
      transition={{
        duration: 3.2,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    />
  );
}