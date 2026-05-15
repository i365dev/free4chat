# Next.js Advanced Starter 🚀

An opinionated starter skeleton with advanced features for Next.js.

Use Tailwind CSS, ESLint, Prettier & absolute imports instantly.
Easily extendable zero-config template for pros and beginners.

Check out the [Demo website.](https://nextjs-advanced-starter.vercel.app/)

## Table of Contents

- [Next.js Advanced Starter 🚀](#nextjs-advanced-starter-)
  - [Table of Contents](#table-of-contents)
  - [Why?](#why)
  - [Features](#features)
  - [Who this template is for](#who-this-template-is-for)
  - [How to use](#how-to-use)
  - [Explanation why some dependencies are in this template](#explanation-why-some-dependencies-are-in-this-template)
    - [@tailwindcss/forms](#tailwindcssforms)
    - [@tailwindcss/typography](#tailwindcsstypography)
  - [Extending the template](#extending-the-template)
    - [Config files](#config-files)
    - [Changing the font](#changing-the-font)
    - [Configuring ESLint rules](#configuring-eslint-rules)
    - [Adding new absolute import paths](#adding-new-absolute-import-paths)
  - [Recommended extensions for VSCode](#recommended-extensions-for-vscode)
  - [Resources](#resources)

## Why?

This template aims to provide a minimal well-thought-out base for building advanced Next.js powered websites.

It feels like there are so many templates and tutorials about configuring stacks out there that just don't work, no matter what you do. This is the template that **just works**. I know how frustrating it can be just wanting to build something but needing DAYS for coming up with the initial configuration. Especially getting Eslint + Prettier + absolute imports to work (well) together is super annoying and I believe using these features should be as simple as clicking a button. Also you probably want to style your webapp and there are few better ways than styling it with Tailwind CSS.

The reason why I created this template in the first place is because I absolutely hate having to copy the same config over to a new project everytime and I don't really want to use existing templates because there always seems to be something wrong with them. Either the config is weird or the maintainers are not transparent with features.

**Inviting you to collaborate**
That being said I invite you to leave your critique about this template. If there's something wrong with ESLint, if prettier doesn't work as expected, if there's a new version of React or if the README is not transparent enough please don't hesitate to open an issue or (even better) a pull request. I've had enough with templates that don't work.

## Features

- Fast design workflow with Tailwind CSS 3.0
  - write css like the cool kids
  - unused classes are purged automatically = really small css bundle size
- TypeScript
  - typed JavaScript
  - drastically reduces errors
  - #1 must have in any web-dev project
- Customizable ESLint config
- Code formatting with Prettier
  - Code is auto-formatted on save
- Inter font
  - Nice looking apple-like open source font.
  - Don't like it? It's easily [replacable](#changing-the-font)
- Standardized absolute imports
  - Import from @components/MyComp instead of ../../components/MyComp

## Who this template is for

**TLDR** This template is for beginners and pros alike. For Pros: You don't have to copy the same config over to a new project. For Beginners: Start coding like the pros without having to configure anything.

If you're a newcomer to Next.js or React and you just want to start building something, this is a great place to start without worrying about configuring rules, code-formatting, css purging etc. You can figure that out later, just get developing and build things people love. I personally feel like that the features in this template are the way to go for starting a new web-dev project. Especially tailwind css has seen explosive growth and is probably going to be the standard way of styling webapps in the future. This is the minimal base-template I wish I've had when I started developing with React.

If you're already a pro, this is the base-template for you. It's incredibly easy to extend or reconfigure. It's deliberately kept small so it stays performant while you build on top of it.

## How to use

1. Click **"Use this Template"** button which will create a new github repo for you automatically
2. Pull the newly created repo by following the github guide which will be shown after you finish step 1.
3. Install dependencies and run dev server:

```bash
npm install
# or
yarn install

# then
npm run dev
# or
yarn dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Explanation why some dependencies are in this template

### @tailwindcss/forms

First party dependency for resetting input styles so you don't have to manually reset like this:

```css
textarea,
input[type="text"],
input[type="search"],
input[type="button"],
input[type="submit"] {
  -webkit-appearance: none;
  border-radius: 0;
}
```

### @tailwindcss/typography

A Tailwind CSS plugin for automatically styling plain HTML content with beautiful typographic defaults. Just add the class "prose" to your html and content will be styled automatically.

E.g this html:

```html
<article class="prose lg:prose-xl">
  <h1>How to set up an enterprise Next.js stack</h1>
  <p>
    Configuring Next.js with TypeScript, ESLint & prettier can become really
    annoying, especially if you're a beginner and don't know the intricate
    details of all the moving parts in a web-dev environment. The most important
    things you have to set up are:
  </p>
  <ul>
    <li>A working ESLint config</li>
    <li>Prettier plugins that auto-format your code</li>
    <li>Absolute imports</li>
  </ul>
</article>
```

will be rendered like this:

![prose output](https://i.imgur.com/xJD5Ojv.png)

If you don't need or want this dependency you can safely remove it.

## Extending the template

### Config files

| File name               | What it does                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `tsconfig.json`         | TypeScript configuration. Tells IDE which absolute imports exist and works in conjunction with .babelrc   |
| `.eslintrc.json`        | Config file for finding and fixing problems in code. E.g: No function should be used before it's defined. |
| `tailwind.config.js`    | TailwindCSS config. Adds new sizes, shadows, borders etc. to your tailwind classes.                       |
| `postcss.config.js`     | Tells your project to include TailwindCSS in build chain.                                                 |
| `prettier.config.js`    | Rules for formatting your code. E.g: indent code 6 spaces instead of 4                                    |
| `.vscode/settings.json` | Custom settings for your VSCode workspace. Tells VSCode to auto-format code on save.                      |

### Changing the font

1. In `src/pages/_app.tsx` replace the link tag with your url (can be Google Fonts, Adobe Typekit, etc.)

```html
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
  rel="stylesheet"
/>
```

2. In tailwind.config.js replace "Inter" with your custom font

```javascript
extend: {
  fontFamily: {
    sans: ["Inter", ...defaultTheme.fontFamily.sans],
}
```

As of Next 10.0.2 google fonts are optimized automatically: <https://nextjs.org/blog/next-10-2#automatic-webfont-optimization>

Tip: The font you choose should have at least these weights: 400, 500, 600, 700, 800. You need these weights for the tailwind font classes to have an effect. E.g if you don't include the weight 500, the class "font-medium" won't have any effect.

### Configuring ESLint rules

If you need additional rules or want to turn off specific rules just edit `.eslintrc.js`. Only change the order of plugins and items in the "extends" array if you know what you're doing as this can have unexpected side effects: Items lower down the list override previous extensions. This is the intended behaviour so you can extend and configure existing rules easily.

### Adding new absolute import paths

This will instruct Next.js to set up a new alias to your specific folder. If you try to import a file with @myalias now it will still throw an error however because we need to tell our IDE that this path actually exists:

Add path in `.tsconfig`

```javascript
"@myalias/*": ["./src/myaliasfolder/*"]
```

That's it! Nextjs 11 now automatically sets up babel and everything else and just works. In previous releases you had to manually configure babel as well.

## Recommended extensions for VSCode

If you're a beginner and don't know which extensions you need, definitely install these:

1. [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint): Adds error highlighting to VSCode.
2. [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode): Auto-fixes formatting errors everytime you hit save.
3. [TailwindCSS Intellisense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss): Tailwind className suggestions as you type.

## Resources

If you're not yet familiar with some of the technologies used in this project here are some resources to help you get started:

[Tailwind CSS course](https://tailwindcss.com/course): Free course by the creators of tailwind. Definitely check it out. It helps you "think" in tailwind. E.g before going through this course I styled my webapps by adding classes from the beginning. However, a much better approach is to 1) semantically structure your html without any classes and 2) to then add styling by using tailwind classes.

[ESLint config guide](https://eslint.org/docs/user-guide/configuring): If you need to configure ESLint read their documentation (or at least the parts you need). You'll be surprised how much just makes sense after that.
