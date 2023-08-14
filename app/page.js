import Image from 'next/image'
import styles from './page.module.css'

export default function Home() {
  return (
    <main className={styles.main}>
      <div className={styles.description}>
        <p>
          Get started by &nbsp;
          <code className={styles.code}>
            <a href="https://github.com/InftyAI">InftyAI</a>
          </code>
        </p>
        <div>
          <h1>
            Exploring the infinite possibilities of AI.
          </h1>
        </div>
      </div>
    </main>
  )
}
