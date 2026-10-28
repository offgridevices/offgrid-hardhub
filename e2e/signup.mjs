// Steps a person takes, shared by the tests. The sign-in page: make a new
// account with a password.
// The end-to-end stack sets ALLOW_SIGNUP=1, so every test can make its own.
export const E2E_PASSWORD = "hardhub end-to-end password";

export async function signUp(page, email, password = E2E_PASSWORD) {
  const submit = page.getByTestId("signin-submit");
  await submit.waitFor({ timeout: 20000 });
  // the page asks the server which form to show first
  await page.waitForFunction(() => !document.querySelector('[data-testid="signin-submit"]')?.disabled, null, { timeout: 20000 });
  if (!(await page.getByTestId("signin-password-again").count())) await page.getByTestId("signin-switch").click();
  await page.getByTestId("signin-email").fill(email);
  await page.getByTestId("signin-password").fill(password);
  await page.getByTestId("signin-password-again").fill(password);
  await submit.click();
}

/** Settings folds HardHub's own chat away once it is set up: open it */
export async function openOwnChat(page) {
  const own = page.getByTestId("own-chat");
  await own.waitFor({ timeout: 10000 });
  if (!(await own.evaluate((d) => d.open))) await page.getByTestId("own-chat-toggle").click();
}
