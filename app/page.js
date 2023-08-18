import Image from 'next/image'
import styles from './page.module.css'

export default function Home() {
  return (
    <main className={styles.main}>
      <div className={styles.description}>
        <p>
          🛸&nbsp;
          <code className={styles.code}>InftyAI</code>
        </p>
      </div>
      <div>
        <a
          href="https://github.com/InftyAI"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            src="/logo.png"
            alt="InftyAI Logo"
          //  className={styles.vercelLogo}
            width={520}
            height={397}
            priority
          />
        </a>
      </div>

      <div className={styles.center}>
        <h1>
          Exploring the infinite possibilities of AI.
        </h1>
      </div>
    </main>
  )
}
