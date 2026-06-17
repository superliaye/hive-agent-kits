// Temporary scratch file to prove CI goes red on a broken gate. Deliberate type
// error: a string is not assignable to number. Reverted before the PR merges.
export const ciRedProbe: number = "this is not a number";
