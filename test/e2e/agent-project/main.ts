function helloWorld(name: string = "World"): string {
    return `Hello, ${name}!`;
}

console.log(helloWorld());        // "Hello, World!"
console.log(helloWorld("Josh"));  // "Hello, Josh!"